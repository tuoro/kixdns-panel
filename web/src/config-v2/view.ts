import { effectiveProtocol, PROTOCOL_LABEL, type BlockResponse, type Model, type UpstreamGroup } from '../config-model/model'

// 次数写成中文习惯的大数：9,876 · 31.7 万 · 1.2 亿 / Counts in Chinese magnitudes: 9,876 · 31.7 万 · 1.2 亿
export function fmtCount(n: number): string {
  // 数和单位之间是不换行的空格，折行不会把「1.8」和「万」拆开 / A no-break space joins number and unit, so a wrap never splits 1.8 from 万
  if (n >= 1e8) return `${trim(n / 1e8)}\u00a0亿`
  if (n >= 1e4) return `${trim(n / 1e4)}\u00a0万`
  return n.toLocaleString('en-US')
}
// 「次」跟在万、亿后面不再空一格（1.8 万次），跟在数字后面照常空一格（3,402 次） / 次 follows 万 and 亿 directly (1.8 万次) and a plain number after a space (3,402 次)
export function fmtTimes(n: number): string {
  return n >= 1e4 ? `${fmtCount(n)}次` : `${fmtCount(n)}\u00a0次`
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''))

export function protocolsOf(g: UpstreamGroup): string {
  return [...new Set(g.addresses.map((a) => PROTOCOL_LABEL[effectiveProtocol(a)]))].join('、')
}
export function groupBrief(g: UpstreamGroup): string {
  if (!g.addresses.length) return '还没有地址'
  return `${protocolsOf(g)} · ${g.addresses.length} 个地址`
}

export function blockOptions(model: Model): { value: BlockResponse; label: string }[] {
  const d = model.defaults.block
  const name = d === 'zero' ? '空地址' : d
  return [
    { value: 'default', label: `沿用默认（${name}）` },
    { value: 'NXDOMAIN', label: 'NXDOMAIN · 域名不存在' },
    { value: 'REFUSED', label: 'REFUSED · 拒绝回答' },
    { value: 'zero', label: '空地址 · 0.0.0.0 和 ::' },
    { value: 'NOERROR', label: '空回答 · 有这个域名但没有记录' },
    { value: 'SERVFAIL', label: 'SERVFAIL · 服务器出错' },
  ]
}

// 句子最后几个字绑在一起不折行：中文折行时末行不会只剩一两个字 / Binds a sentence's last few characters so a Chinese wrap never leaves one or two alone on the last line
export function keepTail(text: string, size = 5): [string, string] {
  if (text.length <= size * 2) return [text, '']
  return [text.slice(0, -size), text.slice(-size)]
}

// 规则最近一次改动：ISO 时间读成「3 天前」，导入的那些写的是「导入」就原样显示 / A rule's last edit: an ISO time reads as 「3 天前」; imported ones say 「导入」 as written
export function editedText(edited: string): string {
  const t = Date.parse(edited)
  if (Number.isNaN(t)) return edited
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))} 个月前`
  return `${Math.floor(s / (86400 * 365))} 年前`
}
