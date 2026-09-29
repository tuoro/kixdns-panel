/**
 * JSON 视图里可以软换行的地方（放一个 <wbr>）：长键在「_」后面断，路径和网址在目录边界的「/」后面断。
 *
 * 「/」看后面是什么：后面只剩一到三位数字（网段的前缀长度，如 192.168.1.0/24、10.0.0.0/8）时不放，
 * 所以网段不会从中间断开；https://223.5.5.5/dns-query 和 kixdns2/GeoLite2 还是在「/」后面断（审计第四轮 C4、第五轮 C1）。
 * 「://」后面、开头的「/」和「.」后面都不放，1.1.1.1:53 这样的地址保持完整。
 *
 * Where the JSON view may wrap (a <wbr> goes there): long keys after 「_」, paths and URLs after the 「/」 of a directory boundary.
 * The slash is judged by what follows it: no break before a trailing prefix length of one to three digits (192.168.1.0/24,
 * 10.0.0.0/8), so a CIDR never splits, while https://223.5.5.5/dns-query and kixdns2/GeoLite2 still wrap after the slash
 * (audit round 4, C4; round 5, C1). Never after 「://」, a leading 「/」 or a 「.」, so an address such as 1.1.1.1:53 stays whole.
 */
export const JSON_SOFT_BREAK = /_(?=[A-Za-z0-9])|(?<=[A-Za-z0-9_.-])\/(?=[A-Za-z0-9_.-])(?!\d{1,3}(?![A-Za-z0-9_.-]))/g

/** 每个软换行点在文字里的位置（紧跟在「_」或「/」之后） / The offset of every soft break, just after its 「_」 or 「/」 */
export function softBreakOffsets(text: string): number[] {
  return [...text.matchAll(new RegExp(JSON_SOFT_BREAK.source, 'g'))].map((match) => match.index + match[0].length)
}
