import { describe, expect, it } from 'vitest'
import { softBreakOffsets } from './soft-breaks'

// 把每个软换行点画成「|」 / Draws every soft break as 「|」
function marked(text: string): string {
  return softBreakOffsets(text).reverse().reduce((result, offset) => `${result.slice(0, offset)}|${result.slice(offset)}`, text)
}

describe('JSON 视图的软换行点', () => {
  it('长键在下划线后面断，不在单词中间断', () => {
    expect(marked('statistics_anonymize_client_ip')).toBe('statistics_|anonymize_|client_|ip')
    expect(marked('trailing_')).toBe('trailing_')
  })

  it('网址和路径在目录边界的斜杠后面断，数字结尾的目录也算（审计第五轮 C1）', () => {
    expect(marked('https://223.5.5.5/dns-query, https://1.12.12.12/dns-query')).toBe('https://223.5.5.5/|dns-query, https://1.12.12.12/|dns-query')
    expect(marked('https://dns.alidns.com/dns-query')).toBe('https://dns.alidns.com/|dns-query')
    expect(marked('"/var/lib/kixdns2/GeoLite2-Country.mmdb"')).toBe('"/var/|lib/|kixdns2/|GeoLite2-Country.mmdb"')
  })

  it('网段的前缀长度前面不断，「://」后面也不断（审计第四轮 C4）', () => {
    for (const cidr of ['192.168.1.0/24', '10.0.0.0/8', 'fd00::/8', '2001:db8::/128', '0.0.0.0/32, 240.0.0.0/4']) expect(marked(cidr)).toBe(cidr)
    expect(marked('https://dns.google')).toBe('https://dns.google')
    expect(marked('1.1.1.1:53')).toBe('1.1.1.1:53')
  })
})
