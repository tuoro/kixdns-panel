import { describe, expect, it } from 'vitest'
import { segmentLogMessage } from './logs'

const rebuild = (message: string) => segmentLogMessage(message).map((segment) => segment.text).join('')
const strong = (message: string) => segmentLogMessage(message).filter((segment) => segment.strong).map((segment) => segment.text)

describe('日志正文分段', () => {
  it('标出 key=value 的值，键和其余文字不动', () => {
    const message = 'request completed pipeline=default transport=udp elapsed_ms=9'
    expect(strong(message)).toEqual(['default', 'udp', '9'])
    expect(rebuild(message)).toBe(message)
  })

  it.each([
    '',
    'no fields at all',
    'upstream request timed out, continuing with next configured resolver',
    'doh upstream unreachable upstream=dns.google/dns-query attempt=2',
    'qname=例子.中国 remaining_ttl=28',
    'weird==value and trailing=',
    '=leading equals',
    'path=/var/lib/kixdns/geo.dat size=1048576',
    'a=1 b=2 c=3 d=4 e=5',
    '  spaced   out  message  ',
    'multi\nline=value\nrest',
  ])('拼回去和原串逐字相同：%j', (message) => {
    expect(rebuild(message)).toBe(message)
  })

  it('等号后面没有值时不标，也不吞掉那个等号', () => {
    expect(strong('trailing= next=ok')).toEqual(['ok'])
    expect(rebuild('trailing= next=ok')).toBe('trailing= next=ok')
  })

  it('值里带等号时整段算值，不在中间再切一刀', () => {
    expect(strong('token=a=b=c')).toEqual(['a=b=c'])
  })

  it('数字开头的词不当作键，避免把普通文字切碎', () => {
    const message = '9=nine but 1024mb=large'
    expect(strong(message)).toEqual(['large'])
    expect(rebuild(message)).toBe(message)
  })

  it('没有字段时只交回一段，不产生空段', () => {
    expect(segmentLogMessage('plain message')).toEqual([{ text: 'plain message', strong: false }])
    expect(segmentLogMessage('')).toEqual([])
  })
})
