export interface LogSegment {
  text: string
  strong: boolean
}

// key=value 的键：字母或下划线开头，后面允许字母、数字、下划线、点和连字符。
const FIELD = /([A-Za-z_][\w.-]*=)(\S+)/g

/**
 * 把日志正文里 `key=value` 的值标出来，其余原样留下。
 *
 * 只认这一种模式，不做别的推断。日志正文是内核原样透传的数据，任何"聪明"的
 * 改写都可能把它读歪；把分段拼回去必须和原串逐字相同，这一条由测试守着。
 *
 * Marks the value half of `key=value` in a log message and leaves everything
 * else alone. This one pattern and nothing else: the message is data passed
 * through verbatim from the kernel, and any cleverer rewriting risks changing
 * what it says. Concatenating the segments must reproduce the original string
 * character for character, which the tests hold to.
 */
export function segmentLogMessage(message: string): LogSegment[] {
  const segments: LogSegment[] = []
  let cursor = 0
  for (const match of message.matchAll(FIELD)) {
    const start = match.index
    const [, key, value] = match as unknown as [string, string, string]
    if (start > cursor) segments.push({ text: message.slice(cursor, start), strong: false })
    segments.push({ text: key, strong: false })
    segments.push({ text: value, strong: true })
    cursor = start + key.length + value.length
  }
  if (cursor < message.length) segments.push({ text: message.slice(cursor), strong: false })
  return segments
}
